# Hugging Face Spaces (Docker SDK) build for the Chatterbox voice service.
# HF Spaces routes traffic to whatever port "app_port" in README.md's YAML
# frontmatter names (7860) - this listens there via $PORT so the same
# image also works fine outside HF if you ever want it to.
#
# NOTE: this Dockerfile was never actually built anywhere - the sandbox
# this was written in blocks both PyPI and Hugging Face outright, so
# there was no way to verify the build here. It follows Chatterbox's and
# HF Spaces' own documented conventions exactly; if the build fails on
# HF's side, paste me the build log and I will fix it from here.

FROM python:3.11-slim

WORKDIR /app

# torchaudio needs libsndfile at runtime to read/write audio files.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV CHATTERBOX_DEVICE=cpu
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
