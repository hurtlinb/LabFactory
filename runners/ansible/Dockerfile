FROM node:20-bullseye
WORKDIR /runner
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
RUN apt-get update \
  && apt-get install -y git wget unzip ansible \
  && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["./entrypoint.sh"]
