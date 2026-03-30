// src/main/java/com/sherbyte/model/Article.java
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
@Table(name = "articles")
public class Article {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    private String title;
    private String preview;

    @Column(name = "body_ai", columnDefinition = "TEXT")
    private String bodyAi;

    @Column(name = "image_url")
    private String imageUrl;

    private String category;
    private String source;

    @Column(name = "source_url")
    private String sourceUrl;

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "topics", columnDefinition = "text[]")
    private List<String> topics;

    @Column(name = "trending_score")
    private double trendingScore = 0.0;

    @Column(name = "like_count")
    private int likeCount = 0;

    @Column(name = "view_count")
    private int viewCount = 0;

    @Column(name = "save_count")
    private int saveCount = 0;

    @Column(name = "published_at")
    private OffsetDateTime publishedAt;

    @Column(name = "created_at")
    private OffsetDateTime createdAt;

    @Column(name = "is_published")
    private boolean isPublished = true;

    @Column(name = "is_flagged")
    private boolean isFlagged = false;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "quiz", columnDefinition = "jsonb")
    private String quiz;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "word_of_day", columnDefinition = "jsonb")
    private String wordOfDay;
}
