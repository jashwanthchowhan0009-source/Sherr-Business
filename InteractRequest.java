// src/main/java/com/sherbyte/dto/InteractRequest.java
package com.sherbyte.dto;

import jakarta.validation.constraints.NotBlank;

public record InteractRequest(
        @NotBlank String articleId,
        @NotBlank String category,
        @NotBlank String action,
        int durationSec) {
}
