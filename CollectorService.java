// src/main/java/com/sherbyte/service/CollectorService.java
package com.sherbyte.service;

import com.fasterxml.jackson.databind.*;
import com.rometools.rome.feed.synd.SyndEntry;
import com.rometools.rome.feed.synd.SyndFeed;
import com.rometools.rome.io.*;
import com.sherbyte.model.RawArticle;
import com.sherbyte.repository.RawArticleRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import java.net.URL;
import java.time.OffsetDateTime;
import java.util.*;

@Slf4j
@Service
public class CollectorService {

    private final RawArticleRepository rawRepo;
    private final RestTemplate restTemplate;

    @Value("${app.newsapi.key}")
    private String newsApiKey;
    @Value("${app.gnews.key}")
    private String gnewsKey;

    private static final List<String[]> RSS_FEEDS = List.of(
            new String[] { "https://www.thehindu.com/news/feeder/default.rss", "The Hindu" },
            new String[] { "https://indianexpress.com/feed/", "Indian Express" },
            new String[] { "https://www.livemint.com/rss/news", "Livemint" },
            new String[] { "https://economictimes.indiatimes.com/rss.cms", "Economic Times" },
            new String[] { "https://feeds.feedburner.com/ndtvnews-top-stories", "NDTV" },
            new String[] { "https://www.downtoearth.org.in/rss/news", "Down to Earth" },
            new String[] { "https://scroll.in/rss", "Scroll" },
            new String[] { "https://thewire.in/rss", "The Wire" },
            new String[] { "https://inc42.com/feed/", "Inc42" },
            new String[] { "https://analyticsindiamag.com/feed/", "Analytics India" });

    public CollectorService(RawArticleRepository rawRepo, RestTemplate restTemplate) {
        this.rawRepo = rawRepo;
        this.restTemplate = restTemplate;
    }

    public int runCollection() {
        log.info("Starting collection cycle...");
        List<RawArticle> all = new ArrayList<>();
        all.addAll(fetchNewsApi());
        all.addAll(fetchGNews());
        for (String[] feed : RSS_FEEDS) {
            all.addAll(fetchRss(feed[0], feed[1]));
        }
        int saved = 0;
        for (RawArticle a : all) {
            try {
                if (!rawRepo.existsBySourceUrl(a.getSourceUrl())) {
                    rawRepo.save(a);
                    saved++;
                }
            } catch (Exception e) {
                log.debug("Skip duplicate: {}", a.getSourceUrl());
            }
        }
        log.info("Collection done: {} articles stored", saved);
        return saved;
    }

    private List<RawArticle> fetchNewsApi() {
        if (newsApiKey == null || newsApiKey.isBlank())
            return List.of();
        try {
            String url = "https://newsapi.org/v2/top-headlines?country=in&pageSize=50&apiKey=" + newsApiKey;
            JsonNode root = restTemplate.getForObject(url, JsonNode.class);
            List<RawArticle> result = new ArrayList<>();
            if (root != null && root.has("articles")) {
                for (JsonNode a : root.get("articles")) {
                    RawArticle ra = new RawArticle();
                    ra.setSource(a.path("source").path("name").asText("NewsAPI"));
                    ra.setSourceUrl(a.path("url").asText());
                    ra.setTitle(a.path("title").asText());
                    ra.setBody(a.path("content").asText(a.path("description").asText()));
                    ra.setImageUrl(a.path("urlToImage").asText());
                    result.add(ra);
                }
            }
            return result;
        } catch (Exception e) {
            log.warn("NewsAPI error: {}", e.getMessage());
            return List.of();
        }
    }

    private List<RawArticle> fetchGNews() {
        if (gnewsKey == null || gnewsKey.isBlank())
            return List.of();
        try {
            String url = "https://gnews.io/api/v4/top-headlines?country=in&max=50&lang=en&token=" + gnewsKey;
            JsonNode root = restTemplate.getForObject(url, JsonNode.class);
            List<RawArticle> result = new ArrayList<>();
            if (root != null && root.has("articles")) {
                for (JsonNode a : root.get("articles")) {
                    RawArticle ra = new RawArticle();
                    ra.setSource(a.path("source").path("name").asText("GNews"));
                    ra.setSourceUrl(a.path("url").asText());
                    ra.setTitle(a.path("title").asText());
                    ra.setBody(a.path("content").asText());
                    ra.setImageUrl(a.path("image").asText());
                    result.add(ra);
                }
            }
            return result;
        } catch (Exception e) {
            log.warn("GNews error: {}", e.getMessage());
            return List.of();
        }
    }

    private List<RawArticle> fetchRss(String feedUrl, String sourceName) {
        try {
            SyndFeed feed = new SyndFeedInput().build(new XmlReader(new URL(feedUrl)));
            List<RawArticle> result = new ArrayList<>();
            for (SyndEntry entry : feed.getEntries().subList(0, Math.min(20, feed.getEntries().size()))) {
                RawArticle ra = new RawArticle();
                ra.setSource(sourceName);
                ra.setSourceUrl(entry.getLink());
                ra.setTitle(entry.getTitle());
                ra.setBody(entry.getDescription() != null ? entry.getDescription().getValue() : "");
                result.add(ra);
            }
            return result;
        } catch (Exception e) {
            log.warn("RSS error {}: {}", sourceName, e.getMessage());
            return List.of();
        }
    }
}
