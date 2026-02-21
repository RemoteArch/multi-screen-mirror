FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app.py /app/app.py
COPY cert.pem /app/cert.pem
COPY key.pem /app/key.pem

EXPOSE 4433/udp

CMD ["python", "/app/app.py"]
