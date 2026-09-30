FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client sshpass \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir ansible-core==2.15.13 pywinrm \
    && mkdir /workspace
COPY ansible/collections.json /opt/collections.json
RUN ansible-galaxy collection install -r /opt/collections.json
ENV ANSIBLE_LOCAL_TEMP=/tmp/ansible HOME=/tmp ANSIBLE_HOST_KEY_CHECKING=False
ENV ANSIBLE_COLLECTIONS_PATHS=/root/.ansible/collections
WORKDIR /workspace
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=10s", "1800s", "ansible-playbook"]
