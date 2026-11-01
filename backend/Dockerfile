FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app
# CPU-only torch keeps the image small; Docling is the primary PDF parser in containers.
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -e '.[docling]' \
 && python -m spacy download en_core_web_sm
COPY seed_data ./seed_data

EXPOSE 8000
