# Web Novel Scraper & Translator

This project is a TypeScript-based application designed to:
1.  **Scrape** web novel chapters from various configurable sources.
2.  **Translate** the scraped content into English using AI translation services, with support for both cloud-based (DeepSeek) and local (Ollama) models.

## Project Overview

The primary goal is to automate the process of:
1.  **Scraping:** Fetching chapter content from web novel websites, handling different site structures through configuration.
2.  **Translation:** Sending the scraped text (primarily aimed at Chinese-to-English) to AI translation services to get high-quality English translations.

The project is structured to handle multiple novel series, manage configurations for each, and process chapters efficiently using concurrency.

## Core Features

*   **Scraper (`src/scraper.ts`):**
    *   **Configurable Site Support:** Can be configured to scrape different websites by defining site-specific CSS selectors for chapter links, titles, and content (`siteSpecificScrapingConfigs` in `scraper.ts`).
        *   Examples provided for `www.biquge345.com` and `www.biquge900.com`.
    *   **Chapter Number Extraction:** Extracts chapter numbers from link text, supporting both Arabic and Chinese numerals (e.g., "第123章", "一百二十三章").
    *   **Content Cleaning:** Removes common boilerplate text, ads, and unwanted HTML elements from scraped content. Uses string similarity to identify and remove repetitive unwanted lines.
    *   **Encoding Handling:** Supports different character encodings (e.g., UTF-8, GBK) for websites using `iconv-lite`.
    *   Downloads raw chapter text into organized folders (`outputs/raw/<series_identifier>`).
    *   Includes basic politeness delays (`REQUEST_DELAY_MS`) between requests to the same source.
    *   Skips already downloaded chapters to avoid redundant work.
    *   Uses a `PromisePool` for concurrent processing of different novel series.

*   **Translation Services:**
    *   **DeepSeek API Translator (`src/translate_ds.ts`):**
        *   Utilizes the official DeepSeek API for high-quality translations.
        *   Requires `APIKEY_DEEPSEEK` environment variable.
        *   Outputs to `outputs/en/<series_identifier>`.
    *   **Local Ollama Translator (`src/translate.ts`):**
        *   Supports translation using a local Ollama instance.
        *   Allows using various models available through Ollama (e.g., Gemma, Llama).
        *   Configurable via `BASE_URL` and `MODEL_NAME` environment variables.
        *   Outputs to `outputs/en_local/<series_identifier>`.
    *   **Common Translation Features:**
        *   **Custom Prompts & Glossaries:** Supports detailed system prompts and series-specific glossaries to guide the AI for better context and consistency.
        *   **Retry Mechanism:** Implements retries with exponential backoff for API calls to handle transient network issues.
        *   **Streaming:** Streams responses from the AI services for live progress and potentially large chapter content.
        *   **Concurrency:** Uses a `PromisePool` to translate multiple chapters concurrently.
        *   **Skip Existing:** Avoids re-translating chapters if an output file already exists.
        *   **Chapter Range Filtering:** Allows specifying `translateChapterMin` and `translateChapterMax` in the series configuration to translate only a specific range of chapters.
        *   **Dry Run Mode:** Supports a `DRY_RUN_TRANSLATION` mode to simulate the process without making API calls or writing files.
        *   **Temporary Files:** Saves live translation streams to temporary files (`tmp/live-translations*`), which can be useful for recovery in case of interruption.

*   **Configuration (`src/lib/config.ts`, `src/lib/schema.ts`):**
    *   **Series Configuration:** Managed via a `series-config.yaml` file in the root directory.
        *   Each series is identified by a unique key (e.g., `my-novel-identifier`).
        *   Settings include `sourceUrl`, `glossary` (can be inline text or a path to a file), `customInstructions`, `skipTranslation` flag, and chapter range filters (`translateChapterMin`, `translateChapterMax`).
        *   Configuration schema is validated using `zod`.
    *   **Environment Variables:** Uses a `.env` file in the root directory for sensitive information (like API keys) and global settings.

*   **Utilities:**
    *   **Promise Pool (`src/lib/promise-pool.ts`):** A robust utility for managing concurrent asynchronous tasks with a defined concurrency limit.
    *   **Number Parsing (`src/lib/number.ts`):** Handles conversion of Chinese numerals to Arabic numbers for chapter extraction.

## Setup & Usage

1.  **Clone the repository.**
2.  **Install dependencies:** `npm install` (or `yarn install`)
3.  **Configuration:**
    *   Create a `.env` file in the root directory. Refer to the "Environment Variables" section below for required and optional variables.
    *   Create and populate `series-config.yaml` in the root directory with the details of the novels you want to process. Example structure:
        ```yaml
        my-novel-identifier:
          sourceUrl: "https://www.biquge345.com/book/12345/"
          glossary: |
            Some Term: Translated Term
            Another Name: Another Translated Name
          # customInstructions: "Translate in a very formal tone."
          # skipTranslation: false
          # translateChapterMin: 10
          # translateChapterMax: 50
        
        another-novel:
          sourceUrl: "https://www.biquge900.com/Book/12/34567"
          # ... other settings
        ```
4.  **Running the Scripts (from `package.json`):**
    *   **Scrape chapters:** `npm run sync-raws`
    *   **Translate using DeepSeek:** `npm run translate:ds`
    *   **Translate using Ollama:** `npm run translate:ollama`
        *   Ensure your Ollama instance is running and the specified model (see `MODEL_NAME` env var) is pulled/available.

## Environment Variables

Create a `.env` file in the project root with the following variables as needed:

*   `APIKEY_DEEPSEEK`: (Required for DeepSeek translator) Your API key for the DeepSeek service.
*   `DEEPSEEK_API_URL`: (Optional) Defaults to `https://api.deepseek.com/chat/completions`.
*   `DEEPSEEK_MODEL_NAME`: (Optional) Defaults to `deepseek-chat`.
*   `BASE_URL`: (Optional, for Ollama) URL of your Ollama API. Defaults to `http://172.21.16.1:11434` (as defined in `src/lib/config.ts`).
*   `MODEL_NAME`: (Optional, for Ollama) The Ollama model to use. Defaults to `hf.co/unsloth/gemma-3-27b-it-qat-GGUF:latest` (ensure this or your chosen model is pulled in Ollama).
*   `TRANSLATION_CONCURRENCY`: (Optional) Number of concurrent translation tasks. Defaults to `3` for DeepSeek and `1` for Ollama.
*   `DRY_RUN_TRANSLATION`: (Optional) Set to `true` to prevent actual API calls and file writes during translation.

**Note:** A significant portion of the codebase was developed with the assistance of AI coding tools.

## Extending

*   **Adding Scraper Support for New Sites:**
    1.  Identify the CSS selectors for chapter links, chapter titles, and chapter content on the new site.
    2.  Add a new entry to `siteSpecificScrapingConfigs` in `src/scraper.ts` with the site's hostname as the key and the required selectors and configuration (e.g., `encoding`, `extraTextToRemove`).
    3.  Test thoroughly. You might need to adjust content cleaning logic or encoding handling.