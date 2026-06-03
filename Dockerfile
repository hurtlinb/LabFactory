FROM node:20-bullseye

# Install Terraform and Ansible so the demo runner has the binaries available.
RUN apt-get update \
  && apt-get install -y wget unzip python3-pip sshpass \
  && wget -q -O /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.5.4/terraform_1.5.4_linux_amd64.zip \
  && unzip /tmp/terraform.zip -d /usr/local/bin \
  && pip3 install --no-cache-dir --upgrade pip setuptools wheel \
  && pip3 install --no-cache-dir "ansible-core>=2.15,<2.16" pywinrm \
  && ansible-galaxy collection install "ansible.windows:==2.3.0" "community.general:==8.5.0" \
  && rm /tmp/terraform.zip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

CMD ["npm", "run", "demo"]
