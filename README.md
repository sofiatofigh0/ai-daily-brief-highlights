# AI Daily Brief Highlights

This project automatically synthesizes daily highlights from the *AI Daily Brief* podcast and presents them in a simple web UI. The goal is to turn long-form audio content into structured, conversation-ready insights that explain not just what happened, but why it matters and who should care.

## What the app does

Each day, the app:
1. Ingests new podcast episodes
2. Transcribes the audio
3. Generates structured summaries using a large language model
4. Augments those summaries with relevant web context
5. Displays the latest episode by default, with the ability to view past dates

The output is designed to help someone quickly understand and discuss the topic without listening to the full episode.

## How it works (high level)

This project uses a human-in-the-loop, retrieval-augmented generation approach rather than simple summarization.

### Ingestion and orchestration
- Background functions orchestrate ingestion, transcription, retrieval, and summarization
- Work is capped per run to manage cost and avoid timeouts
- The system is designed to be safe to rerun and easy to backfill as logic evolves

### Retrieval (RAG-style augmentation)
- Before summarization, the system retrieves relevant web context using Tavily
- Search queries are generated from the transcript itself to avoid generic or irrelevant sources
- Retrieved snippets are passed into the model as supporting context

This allows the model to add background and implications while staying grounded in real sources.

### Generation
The model produces structured output using a consistent schema:
- One-sentence summary  
- What changed  
- Why it matters now  
- Who should care  
- Key takeaways  
- Related stories  

Prompts prioritize the transcript as the source of truth and use web data cautiously to add clarity rather than invent new facts.

### Evaluation and feedback loops
- Only episodes with real transcripts are eligible for summarization
- Errors are logged and stored alongside episodes for inspection
- Outputs can be selectively regenerated as prompts and requirements change

This creates a lightweight evaluation loop where quality improves over time.

## Why this is a GenAI project

From a product perspective, this project demonstrates several core GenAI concepts:

- **Retrieval-augmented generation (RAG)**  
  External web data is retrieved and injected into the model context to improve relevance and depth.

- **Human-in-the-loop design**  
  The system is built around human judgment, data quality, and iteration rather than one-shot automation.

- **Orchestration**  
  Multiple steps (ingestion, transcription, retrieval, generation) are coordinated through background jobs with clear boundaries and failure handling.

- **Evaluation and iteration**  
  Outputs are stored, inspected, and regenerated as prompts evolve.

- **Structured outputs**  
  The model is constrained to produce predictable, product-friendly JSON instead of free-form text.

## Tech stack

- Frontend: React + Vite  
- Backend: Netlify Functions  
- Database: Supabase (Postgres)  
- LLM: OpenAI  
- Retrieval: Tavily  
- Deployment: Netlify  

## Why this project exists

This started as an experiment in turning unstructured, high-signal content into something more usable and explainable. It evolved into a way to explore how GenAI systems can be designed around human intent, data quality, and real-world use, rather than automation for its own sake.
