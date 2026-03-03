FROM node:20-bullseye

# Install Terraform and Ansible so the demo runner has the binaries available.
RUN apt-get update \
  && apt-get install -y wget unzip ansible \
  && wget -q -O /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.5.4/terraform_1.5.4_linux_amd64.zip \
  && unzip /tmp/terraform.zip -d /usr/local/bin \
  && rm /tmp/terraform.zip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

CMD ["npm", "run", "demo"]
