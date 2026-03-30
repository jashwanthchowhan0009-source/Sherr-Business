package com.sherbyte.model;

import jakarta.persistence.*;
import lombok.Data;
import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@Entity
@Table(name = "interactions")
public class Interaction {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "article_id")
    private UUID articleId;

    private String action; // read, like, save, skip, share, quiz_complete

    @Column(name = "duration_sec")
    private int durationSec = 0;

    @Column(name = "created_at")
    private OffsetDateTime createdAt;
}
