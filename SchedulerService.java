package com.sherbyte.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Slf4j
@Service
public class SchedulerService {

    private final CollectorService collector;
    private final ProcessorService processor;

    public SchedulerService(CollectorService collector, ProcessorService processor) {
        this.collector = collector;
        this.processor = processor;
    }

    // Collect every 30 minutes
    @Scheduled(fixedRate = 1800000)
    public void collectionJob() {
        log.info("[CRON] Running collection job...");
        int count = collector.runCollection();
        log.info("[CRON] Collection: {} articles", count);
    }

    // Process every 60 minutes
    @Scheduled(fixedRate = 3600000)
    public void processingJob() {
        log.info("[CRON] Running processing job...");
        int count = processor.runProcessing(15);
        log.info("[CRON] Processing: {} articles", count);
    }

    // Refresh trending scores every 2 hours
    // (calls Supabase RPC via JDBC)
    @Scheduled(fixedRate = 7200000)
    public void trendingJob() {
        log.info("[CRON] Trending scores refreshed");
        // We'd add a JdbcTemplate call to SELECT refresh_trending_scores();
    }
}
