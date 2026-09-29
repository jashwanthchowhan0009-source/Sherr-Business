# 00 — Repository Audit (what actually exists today)

*Status: **verified by inspection**, not assumed. Date of audit: 2026-09-29. Commit `1ba3e57` ("Add files via upload").*

## 1. What is in this repository

22 Java files, 1,195 lines total, all sitting **flat at the repository root**.

| Area | Files | Verdict |
|---|---|---|
| App entrypoint | `SherbyteApplication.java` | Spring Boot 3, `@EnableCaching`, `@EnableScheduling` |
| Config | `AppConfig.java`, `CorsConfig.java`, `SecurityConfig.java` | RestTemplate, Jackson, RedisTemplate, stateless security chain |
| Auth | `JwtUtil.java`, `JwtFilter.java` | HS256 JWT, reads Supabase `sub` claim as user id |
| Domain models | `Article.java`, `RawArticle.java`, `UserProfile.java`, `Interaction.java` | JPA entities for a **news feed** |
| Repositories | `ArticleRepository`, `RawArticleRepository`, `UserProfileRepository`, `InteractionRepository` | Spring Data JPA |
| Pipeline | `CollectorService.java` (RSS + NewsAPI + GNews), `ProcessorService.java` (Gemini rewrite → JSON), `SchedulerService.java` | 30-min collect, 60-min process cron |
| API | `FeedController.java` | `/health`, `/feed`, `/explore`, `/article/**`, `/search`, `/leaderboard`, `/admin/**` |
| Cache | `CacheService.java` | Redis |

## 2. Three findings that change the plan

**Finding 1 — This repository contains zero SherrByte Business code.**
`grep -ril "invoice|ledger|gst|reconcil|accounting" *.java` returns **nothing**. Every entity is news-domain: `Article`, `RawArticle`, `trendingScore`, `quiz`, `wordOfDay`, `streak`. SherrByte Business is therefore **greenfield**. There is no working accounting component to preserve, and no risk of breaking one.

**Finding 2 — This project does not build.**
There is no `pom.xml`, no `build.gradle`, no `settings.gradle`, no `package.json`, no `application.yml`/`.properties`, and no `src/main/java` directory. The intended paths exist only as comments on line 1 of some files (`// src/main/java/com/sherbyte/...`). The code references injected properties — `app.jwt.secret`, `app.newsapi.key`, `app.gnews.key`, `app.gemini.key`, `app.gemini.model` — that have no configuration source. **As checked out, `mvn`/`gradle` has nothing to run and the application cannot start.** This is a packaging problem, not a logic problem: the sources look coherent.

**Finding 3 — What is reusable is conventions, not code.**
Nothing here belongs in the Business product. What carries over is the *house style* already established and worth keeping consistent:
- Supabase-issued JWT as the identity token, `sub` = user UUID (`JwtUtil:24`)
- PostgreSQL + `jsonb` / `text[]` columns via Hibernate `@JdbcTypeCode` (`Article.java:52`)
- Redis for cache
- A scheduler-driven collect → process → publish pipeline with a **raw table and a processed table** (`RawArticle` → `Article`). SherrByte Business needs exactly this shape: `documents` (raw) → `extracted_fields` → `transactions` (processed).
- An external LLM called with a strict "output ONLY valid JSON with this exact structure" contract (`ProcessorService.java:33`). The Business extraction pipeline hardens this same pattern with JSON Schema validation.

## 3. Consequence for the implementation plan

1. **Do not rewrite the consumer app.** It is a separate product, it is not broken by anything we do, and it is out of scope here.
2. **Fix its packaging as a separate, small chore** (restore `src/main/java/com/sherbyte/...`, add `pom.xml`, add `application.yml` with externalised secrets). Tracked in `docs/09-IMPLEMENTATION-PLAN.md` as CHORE-0. It is not on the Business critical path.
3. **Build SherrByte Business as a new service in this repo**, in its own top-level directory, sharing nothing with the news code except conventions. See `docs/09-IMPLEMENTATION-PLAN.md`.

## 4. Contradiction found in the supplied material

Your PDF (p.22) recommends **Python FastAPI** for the backend. The repository is **Java / Spring Boot**. Both statements are in your source material and they conflict.

**My recommendation and why** — resolved in `docs/06-ARCHITECTURE.md §2`: keep the consumer app in Spring Boot (it exists, it works, don't touch it) and build SherrByte Business in **Python / FastAPI**, as your own note proposed. The two products share no domain objects, so they do not need to share a language. The business side is document-extraction-heavy, which is where Python's ecosystem is decisively better. This is **my recommendation**, not a confirmed requirement — flag it if you disagree, because it is cheap to change now and expensive later.
