FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    cmake \
    cargo \
    coreutils \
    curl \
    findutils \
    gawk \
    git \
    golang-go \
    grep \
    jq \
    nodejs \
    npm \
    ninja-build \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rustc \
    sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
