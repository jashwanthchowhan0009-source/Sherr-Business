// src/main/java/com/sherbyte/SherbyteApplication.java
package com.sherbyte;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableCaching
@EnableScheduling
public class SherbyteApplication {
    public static void main(String[] args) {
        SpringApplication.run(SherbyteApplication.class, args);
    }
}
