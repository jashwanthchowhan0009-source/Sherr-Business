package com.sherbyte.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Data
@Entity
@Table(name = "raw_articles")
public class RawArticle {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    private String source;

    @Column(name = "source_url")
    private String sourceUrl;

    private String title;

    @Column(columnDefinition = "TEXT")
    private String body;

    @Column(name = "image_url")
    private String imageUrl;

    @Column(name = "published_at")
    private OffsetDateTime publishedAt;

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "topics", columnDefinition = "text[]")
    private List<String> topics;

    private String language = "en";

    @Column(name = "is_processed")
    private boolean isProcessed = false;

    @Column(name = "is_duplicate")
    private boolean isDuplicate = false;

    @Column(name = "fetched_at")
    private OffsetDateTime fetchedAt;
}
