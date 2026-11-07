FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DMBOX_DATA_DIR=/data DMBOX_REQUIRE_AUTH=true
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 dmbox && useradd -u 10001 -g dmbox -M dmbox
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server /app/server
RUN mkdir /data && chown dmbox:dmbox /data
USER dmbox
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8765/api/health',headers={'Authorization':'Bearer '+os.environ['DMBOX_API_TOKEN']}); urllib.request.urlopen(r,timeout=3)"
CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8765", "--no-proxy-headers"]
