package com.sherbyte.repository;

import com.sherbyte.model.Interaction;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Repository
public interface InteractionRepository extends JpaRepository<Interaction, UUID> {

    @Query(value = "SELECT cast(article_id as varchar) FROM interactions WHERE user_id = CAST(:userId AS uuid) AND action = :action", nativeQuery = true)
    List<String> findArticleIdsByUserIdAndAction(@Param("userId") String userId, @Param("action") String action);

    @Modifying
    @Transactional
    @Query(value = "INSERT INTO interactions (user_id, article_id, action, duration_sec) " +
            "VALUES (CAST(:userId AS uuid), CAST(:articleId AS uuid), :action, :durationSec) " +
            "ON CONFLICT (user_id, article_id, action) DO NOTHING", nativeQuery = true)
    void upsertInteraction(@Param("userId") String userId, @Param("articleId") String articleId,
            @Param("action") String action, @Param("durationSec") int durationSec);
}
