package com.sherbyte.model;

import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Data
@Entity
@Table(name = "user_profiles")
public class UserProfile {
    @Id
    private UUID id; // references auth.users(id) - assuming Spring Security or Supabase handles user
                     // creation

    private String username;

    @Column(name = "display_name")
    private String displayName;

    @Column(name = "avatar_url")
    private String avatarUrl;

    private String bio;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "interests", columnDefinition = "jsonb")
    private String interests;

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "topics", columnDefinition = "text[]")
    private List<String> topics;

    private int streak = 0;
    private int score = 0;

    @Column(name = "quiz_score")
    private int quizScore = 0;

    @Column(name = "last_active")
    private LocalDate lastActive;

    @Column(name = "push_enabled")
    private boolean pushEnabled = true;

    private String language = "en";
    private String theme = "dark";

    @Column(name = "created_at")
    private OffsetDateTime createdAt;

    @Column(name = "updated_at")
    private OffsetDateTime updatedAt;
}
