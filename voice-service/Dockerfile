# Hugging Face Spaces (Docker SDK) build for the CosyVoice voice service.
#
# BE HONEST WITH YOURSELF ABOUT THIS ONE: CosyVoice2 is a ~0.5B-parameter
# LLM-based TTS model, not the small CPU-tuned Chatterbox Nano this
# service used to run. On HF's free "CPU basic" tier (2 shared vCPUs) it
# will be considerably slower than the old service was, likely well past
# what feels responsive in a live voice conversation. Running this
# locally on your own Mac (see README.md) is the realistic option;
# treat this Dockerfile as here for completeness / a paid-GPU-Space case,
# not as the "free and fine" path the Chatterbox version was.
#
# NOTE: this Dockerfile was never actually built anywhere - the sandbox
# this was written in blocks PyPI and GitHub outright, so there was no
# way to verify the build here. Paste me the build log if it fails.

FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libsndfile1 \
    sox \
    libsox-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone CosyVoice + its Matcha-TTS submodule directly (a plain zip/tarball
# of the repo does NOT include submodule contents - see README.md).
RUN git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git CosyVoice

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
