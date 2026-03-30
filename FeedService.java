// src/main/java/com/sherbyte/service/FeedService.java
package com.sherbyte.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sherbyte.model.Article;
import com.sherbyte.model.UserProfile;
import com.sherbyte.repository.*;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.*;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
public class FeedService {

    // Interest vector update deltas per user action
    private static final Map<String, Double> ACTION_DELTAS = Map.of(
            "read", 0.05,
            "like", 0.10,
            "save", 0.12,
            "share", 0.08,
            "skip", -0.03,
            "quiz_complete", 0.07);

    private final ArticleRepository articleRepo;
    private final UserProfileRepository userRepo;
    private final InteractionRepository interactionRepo;
    private final CacheService cache;
    private final ObjectMapper mapper = new ObjectMapper();

    public FeedService(ArticleRepository articleRepo,
            UserProfileRepository userRepo,
            InteractionRepository interactionRepo,
            CacheService cache) {
        this.articleRepo = articleRepo;
        this.userRepo = userRepo;
        this.interactionRepo = interactionRepo;
        this.cache = cache;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getFeed(String userId, int page, int pageSize) {
        String cacheKey = "feed:" + userId + ":p" + page;
        if (page == 1) {
            Object cached = cache.get(cacheKey);
            if (cached != null)
                return (Map<String, Object>) cached;
        }

        // 1. Load user interest weights
        UserProfile profile = userRepo.findById(userId).orElse(null);
        Map<String, Double> weights = defaultWeights();
        if (profile != null && profile.getInterests() != null) {
            try {
                Map<String, Double> saved = mapper.readValue(profile.getInterests(),
                        mapper.getTypeFactory().constructMapType(HashMap.class, String.class, Double.class));
                weights.putAll(saved);
            } catch (Exception e) {
                /* use defaults */ }
        }

        // 2. Fetch articles from last 48 hours
        OffsetDateTime since = OffsetDateTime.now().minusHours(48);
        List<Article> articles = articleRepo
                .findByIsPublishedTrueAndIsFlaggedFalseAndPublishedAtAfter(
                        since, PageRequest.of(0, 200));

        // 3. Get IDs user already read
        Set<String> seenIds = interactionRepo
                .findArticleIdsByUserIdAndAction(userId, "read")
                .stream().collect(Collectors.toSet());

        // 4. Score and rank unseen articles
        final Map<String, Double> finalWeights = weights;
        List<Article> ranked = articles.stream()
                .filter(a -> !seenIds.contains(a.getId().toString()))
                .sorted((a, b) -> Double.compare(
                        scoreArticle(b, finalWeights),
                        scoreArticle(a, finalWeights)))
                .collect(Collectors.toList());

        // 5. Paginate
        int offset = (page - 1) * pageSize;
        List<Article> pageArticles = ranked.stream()
                .skip(offset).limit(pageSize).collect(Collectors.toList());

        Map<String, Object> result = Map.of(
                "articles", pageArticles,
                "page", page,
                "total", ranked.size(),
                "has_more", ranked.size() > offset + pageSize);

        if (page == 1)
            cache.set(cacheKey, result, 300);
        return result;
    }

    private double scoreArticle(Article a, Map<String, Double> weights) {
        double interestW = weights.getOrDefault(a.getCategory(), 0.5);
        double recencyW = recencyScore(a.getPublishedAt());
        double trendingW = Math.min(1.0, a.getTrendingScore() / 100.0);
        return (interestW * 0.60) + (recencyW * 0.25) + (trendingW * 0.10);
    }

    private double recencyScore(OffsetDateTime publishedAt) {
        if (publishedAt == null)
            return 0.5;
        double ageHours = Duration.between(publishedAt, OffsetDateTime.now()).toMinutes() / 60.0;
        return Math.exp(-0.15 * ageHours); // exponential decay
    }

    @Transactional
    public void logInteraction(String userId, String articleId, String category, String action, int duration) {
        // Validate action
        if (!ACTION_DELTAS.containsKey(action)) {
            throw new IllegalArgumentException("Invalid action: " + action);
        }

        // Insert interaction (ignore duplicate via constraint)
        try {
            interactionRepo.upsertInteraction(userId, articleId, action, duration);
        } catch (Exception e) {
            log.debug("Duplicate interaction skipped");
        }

        // Update interest vector
        double delta = ACTION_DELTAS.get(action);
        userRepo.updateInterest(userId, category, delta);

        // Increment article counter
        UUID artUUID = UUID.fromString(articleId);
        switch (action) {
            case "read" -> articleRepo.incrementViewCount(artUUID);
            case "like" -> articleRepo.incrementLikeCount(artUUID);
            case "save" -> articleRepo.incrementSaveCount(artUUID);
        }

        // Invalidate user feed cache
        cache.delete("feed:" + userId + ":p1");
    }

    private Map<String, Double> defaultWeights() {
        Map<String, Double> m = new HashMap<>();
        List.of("tech", "society", "economy", "nature", "arts", "selfwell", "philo")
                .forEach(c -> m.put(c, 0.5));
        return m;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getExplore(String category, int page) {
        String cacheKey = "explore:" + category + ":p" + page;
        Object cached = cache.get(cacheKey);
        if (cached != null)
            return (Map<String, Object>) cached;

        List<Article> articles = articleRepo.findByCategoryAndIsPublishedTrueOrderByTrendingScoreDesc(
                category.equals("all") ? null : category, PageRequest.of(page - 1, 20));
        Map<String, Object> result = Map.of(
                "articles", articles,
                "category", category,
                "page", page);
        cache.set(cacheKey, result, 600);
        return result;
    }

    public void saveOnboarding(String userId, Map<String, Double> interests, List<String> topics) {
        UserProfile profile = userRepo.findById(userId).orElse(new UserProfile());
        profile.setId(UUID.fromString(userId));
        try {
            profile.setInterests(mapper.writeValueAsString(interests));
        } catch (JsonProcessingException e) {
            log.error("Failed to parse interests", e);
        }
        profile.setTopics(topics);
        userRepo.save(profile);
    }

    public List<Article> getBookmarks(String userId) {
        List<String> articleIds = interactionRepo.findArticleIdsByUserIdAndAction(userId, "save");
        return articleIds.stream()
                .map(id -> articleRepo.findById(UUID.fromString(id)).orElse(null))
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
    }

    // ── MANUAL TRIGGERS ──────────────────────────────────────
    private CollectorService collectorService;
    private ProcessorService processorService;

    @org.springframework.beans.factory.annotation.Autowired
    public void setCollectorService(CollectorService collectorService) {
        this.collectorService = collectorService;
    }

    @org.springframework.beans.factory.annotation.Autowired
    public void setProcessorService(ProcessorService processorService) {
        this.processorService = processorService;
    }

    public void triggerCollect() {
        new Thread(() -> collectorService.runCollection()).start();
    }

    public void triggerProcess() {
        new Thread(() -> processorService.runProcessing(20)).start();
    }
}
