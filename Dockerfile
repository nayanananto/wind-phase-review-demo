FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    PORT=7860 \
    WIND_DATA_MODE=snapshot \
    SEMANTIC_LLM_MODEL=gpt-4o-mini \
    WIND_RUNTIME_DIR=/home/user/app/runtime

RUN useradd --create-home --uid 1000 user
WORKDIR /home/user/app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --chown=user:user . .
USER user
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT', '7860') + '/health', timeout=3)"
CMD ["python", "deployment/server.py"]
