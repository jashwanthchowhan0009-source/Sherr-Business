// src/main/java/com/sherbyte/repository/RawArticleRepository.java
package com.sherbyte.repository;

import com.sherbyte.model.RawArticle;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface RawArticleRepository extends JpaRepository<RawArticle, UUID> {

    boolean existsBySourceUrl(String sourceUrl);

    @Query(value = "SELECT * FROM raw_articles WHERE is_processed = false LIMIT :batchSize", nativeQuery = true)
    List<RawArticle> findUnprocessed(@Param("batchSize") int batchSize);
}
