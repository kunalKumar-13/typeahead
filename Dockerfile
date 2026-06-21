FROM python:3.12-slim

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code
COPY app ./app
COPY scripts ./scripts
COPY static ./static
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

EXPOSE 8000

# Entrypoint generates + loads the dataset on first boot, then starts the API.
ENTRYPOINT ["./docker-entrypoint.sh"]
