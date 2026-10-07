FROM python:3.12-alpine
WORKDIR /app
COPY app.py .
ENV PORT=8080 DELAY_MS=150
EXPOSE 8080
USER nobody
CMD ["python", "app.py"]
