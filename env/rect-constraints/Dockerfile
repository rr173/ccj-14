# 极小镜像：仅 Python 标准库运行时
FROM python:3.12-alpine

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_PATH=/data/doc.json \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY server/ ./server/
COPY web/ ./web/

RUN mkdir -p /data && adduser -D appuser && chown -R appuser:appuser /data /app
USER appuser

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["python", "-u", "server/server.py"]
