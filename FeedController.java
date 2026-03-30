// src/main/java/com/sherbyte/controller/FeedController.java
package com.sherbyte.controller;

import com.sherbyte.dto.InteractRequest;
import com.sherbyte.dto.OnboardRequest;
import com.sherbyte.service.FeedService;
import com.sherbyte.repository.*;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
public class FeedController {

    private final FeedService feedService;
    private final ArticleRepository articleRepo;
    private final UserProfileRepository userRepo;

    public FeedController(FeedService feedService,
            ArticleRepository articleRepo,
            UserProfileRepository userRepo) {
        this.feedService = feedService;
        this.articleRepo = articleRepo;
        this.userRepo = userRepo;
    }

    // ── HEALTH ─────────────────────────────────────────────
    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        return ResponseEntity.ok(Map.of("status", "ok", "version", "2.1.0"));
    }

    // ── PERSONALISED FEED ──────────────────────────────────
    @GetMapping("/feed")
    public ResponseEntity<?> getFeed(
            @RequestParam(defaultValue = "1") int page,
            Authentication auth) {
        String userId = auth.getName();
        return ResponseEntity.ok(feedService.getFeed(userId, page, 20));
    }

    // ── LOG INTERACTION ────────────────────────────────────
    @PostMapping("/interact")
    public ResponseEntity<Map<String, Boolean>> interact(
            @Valid @RequestBody InteractRequest req,
            Authentication auth) {
        feedService.logInteraction(
                auth.getName(), req.articleId(), req.category(),
                req.action(), req.durationSec());
        return ResponseEntity.ok(Map.of("ok", true));
    }

    // ── EXPLORE ────────────────────────────────────────────
    @GetMapping("/explore")
    public ResponseEntity<?> explore(
            @RequestParam(defaultValue = "all") String category,
            @RequestParam(defaultValue = "1") int page) {
        // Served from Redis cache in CacheService
        return ResponseEntity.ok(
                feedService.getExplore(category, page));
    }

    // ── ARTICLE DETAIL ─────────────────────────────────────
    @GetMapping("/article/{id}")
    public ResponseEntity<?> getArticle(@PathVariable String id) {
        return articleRepo.findById(java.util.UUID.fromString(id))
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    // ── USER PROFILE ───────────────────────────────────────
    @GetMapping("/me")
    public ResponseEntity<?> getMe(Authentication auth) {
        return userRepo.findById(auth.getName())
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    // ── ONBOARDING ─────────────────────────────────────────
    @PostMapping("/onboard")
    public ResponseEntity<Map<String, Boolean>> onboard(
            @Valid @RequestBody OnboardRequest req,
            Authentication auth) {
        feedService.saveOnboarding(auth.getName(), req.interests(), req.topics());
        return ResponseEntity.ok(Map.of("ok", true));
    }

    // ── SEARCH ─────────────────────────────────────────────
    @GetMapping("/search")
    public ResponseEntity<?> search(@RequestParam String q) {
        if (q.length() < 2)
            return ResponseEntity.badRequest()
                    .body(Map.of("error", "Query must be at least 2 characters"));
        return ResponseEntity.ok(
                Map.of("results", articleRepo.searchByTitle(q), "query", q));
    }

    // ── ADMIN: MANUAL TRIGGERS ─────────────────────────────
    @PostMapping("/admin/collect")
    public ResponseEntity<?> triggerCollect() {
        feedService.triggerCollect();
        return ResponseEntity.ok(Map.of("status", "collection started"));
    }

    @PostMapping("/admin/process")
    public ResponseEntity<?> triggerProcess() {
        feedService.triggerProcess();
        return ResponseEntity.ok(Map.of("status", "processing started"));
    }
}
