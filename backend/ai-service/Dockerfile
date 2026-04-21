# Dev — FastAPI + uvicorn com reload (StatReload, sem watchfiles).

FROM python:3.11-slim

# Deps de build (psycopg2/asyncpg) + curl pra healthcheck local.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código: em dev vem via bind mount.
COPY . .

EXPOSE 8000

# watchfiles causa crash de memória em Docker/Windows — StatReload (polling) é mais estável.
RUN pip uninstall -y watchfiles 2>/dev/null || true

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--reload", \
     "--reload-exclude", "venv", \
     "--reload-exclude", "__pycache__", \
     "--reload-exclude", ".venv"]
