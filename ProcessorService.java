// src/main/java/com/sherbyte/service/ProcessorService.java
package com.sherbyte.service;

import com.fasterxml.jackson.databind.*;
import com.sherbyte.model.Article;
import com.sherbyte.model.RawArticle;
import com.sherbyte.repository.ArticleRepository;
import com.sherbyte.repository.RawArticleRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import java.util.*;

@Slf4j
@Service
public class ProcessorService {

    private final RawArticleRepository rawRepo;
    private final ArticleRepository articleRepo;
    private final RestTemplate restTemplate;
    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${app.gemini.key}")
    private String geminiKey;
    @Value("${app.gemini.model}")
    private String geminiModel;

    private static final String GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s";

    private static final String SYSTEM_PROMPT = "You are SherByte's AI editor. Transform raw news for Indian readers aged 18-35.\n"
            +
            "Output ONLY valid JSON with this exact structure — no markdown, no preamble:\n" +
            "{\n" +
            "  \"title\": \"Clear headline under 12 words\",\n" +
            "  \"preview\": \"55-65 word plain-language summary\",\n" +
            "  \"body\": \"150-180 word neutral rewrite, no jargon\",\n" +
            "  \"category\": \"tech|society|economy|nature|arts|selfwell|philo\",\n" +
            "  \"topics\": [\"topic1\", \"topic2\"],\n" +
            "  \"quiz\": [{\"q\":\"question\",\"opts\":[\"a\",\"b\",\"c\",\"d\"],\"ans\":0,\"explain\":\"1 sentence\"}],\n"
            +
            "  \"word\": {\"word\":\"term\",\"phonetic\":\"/pron/\",\"part_of_speech\":\"noun\",\"definition\":\"plain def\"}\n"
            +
            "}";

    public ProcessorService(RawArticleRepository rawRepo,
            ArticleRepository articleRepo,
            RestTemplate restTemplate) {
        this.rawRepo = rawRepo;
        this.articleRepo = articleRepo;
        this.restTemplate = restTemplate;
    }

    public int runProcessing(int batchSize) {
        log.info("Starting processing cycle...");
        List<RawArticle> unprocessed = rawRepo.findUnprocessed(batchSize);
        int processed = 0;
        for (RawArticle raw : unprocessed) {
            try {
                processSingle(raw);
                processed++;
                Thread.sleep(12500); // Gemini 2.5 Flash free tier: 5 rpm (1 request every 12 seconds)
            } catch (Exception e) {
                log.error("Failed to process {}: {}", raw.getId(), e.getMessage());
            }
        }
        log.info("Processing done: {}/{}", processed, unprocessed.size());
        return processed;
    }

    private void processSingle(RawArticle raw) throws Exception {
        String prompt = SYSTEM_PROMPT + "\n\nARTICLE:\nTitle: " + raw.getTitle()
                + "\nBody: " + truncate(raw.getBody(), 3000);

        // Build Gemini REST request body
        Map<String, Object> requestBody = Map.of(
                "contents", List.of(Map.of(
                        "parts", List.of(Map.of("text", prompt)))),
                "generationConfig", Map.of("temperature", 0.3, "maxOutputTokens", 1024));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(requestBody, headers);

        String url = String.format(GEMINI_URL, geminiModel, geminiKey);
        ResponseEntity<JsonNode> response = restTemplate.postForEntity(url, entity, JsonNode.class);

        // Extract text from Gemini response
        String text = response.getBody()
                .path("candidates").get(0)
                .path("content").path("parts").get(0)
                .path("text").asText();

        // Strip markdown fences if present
        text = text.strip();
        if (text.startsWith("```")) {
            text = text.replaceAll("```json|```", "").strip();
        }

        JsonNode data = mapper.readTree(text);

        // Build and save Article entity
        Article article = new Article();
        article.setTitle(data.path("title").asText());
        article.setPreview(data.path("preview").asText());
        article.setBodyAi(data.path("body").asText());
        article.setCategory(data.path("category").asText("tech"));
        article.setSource(raw.getSource());
        article.setSourceUrl(raw.getSourceUrl());
        article.setImageUrl(raw.getImageUrl());
        article.setPublishedAt(raw.getPublishedAt());
        article.setQuiz(mapper.writeValueAsString(data.path("quiz")));
        article.setWordOfDay(mapper.writeValueAsString(data.path("word")));

        // Topics array
        List<String> topics = new ArrayList<>();
        data.path("topics").forEach(t -> topics.add(t.asText()));
        article.setTopics(topics);

        articleRepo.save(article);

        // Mark raw as processed
        raw.setProcessed(true);
        rawRepo.save(raw);
    }

    private String truncate(String s, int max) {
        if (s == null)
            return "";
        return s.length() <= max ? s : s.substring(0, max);
    }
}
