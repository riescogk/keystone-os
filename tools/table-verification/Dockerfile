FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=10000
WORKDIR /app
RUN pip install --no-cache-dir 'Pillow>=10,<13' && \
    useradd --system --user-group --uid 10001 kstv
COPY --chown=kstv:kstv kstv/ /app/kstv/
USER kstv
EXPOSE 10000
CMD ["python", "-m", "kstv.hosted_server"]
