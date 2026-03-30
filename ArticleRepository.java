// src/main/java/com/sherbyte/repository/ArticleRepository.java
package com.sherbyte.repository;

import com.sherbyte.model.Article;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Repository
public interface ArticleRepository extends JpaRepository<Article, UUID> {

    // Fetch recent published articles for feed scoring
    List<Article> findByIsPublishedTrueAndIsFlaggedFalseAndPublishedAtAfter(
            OffsetDateTime since, Pageable pageable);

    // Fetch by category for explore
    List<Article> findByCategoryAndIsPublishedTrueOrderByTrendingScoreDesc(
            String category, Pageable pageable);

    // Full-text search on title
    @Query(value = "SELECT * FROM articles WHERE to_tsvector('english', title) @@ plainto_tsquery('english', :q) " +
            "AND is_published = true LIMIT 20", nativeQuery = true)
    List<Article> searchByTitle(@Param("q") String query);

    // Increment view count atomically
    @Modifying
    @Query("UPDATE Article a SET a.viewCount = a.viewCount + 1 WHERE a.id = :id")
    void incrementViewCount(@Param("id") UUID id);

    @Modifying
    @Query("UPDATE Article a SET a.likeCount = a.likeCount + 1 WHERE a.id = :id")
    void incrementLikeCount(@Param("id") UUID id);

    @Modifying
    @Query("UPDATE Article a SET a.saveCount = a.saveCount + 1 WHERE a.id = :id")
    void incrementSaveCount(@Param("id") UUID id);
}
