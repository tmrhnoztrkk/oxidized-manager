FROM python:3.12-slim
RUN pip install --no-cache-dir paramiko==3.5.0
COPY fake.py /fake.py
CMD ["python", "-u", "/fake.py"]
