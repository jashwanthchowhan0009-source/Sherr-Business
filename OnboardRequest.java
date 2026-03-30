// src/main/java/com/sherbyte/dto/OnboardRequest.java
package com.sherbyte.dto;

import java.util.List;
import java.util.Map;

public record OnboardRequest(
        Map<String, Double> interests,
        List<String> topics) {
}
