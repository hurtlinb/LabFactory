FROM node:20-bullseye

# Install Terraform and Ansible so the demo runner has the binaries available.
RUN apt-get update \
  && apt-get install -y wget unzip python3-pip sshpass \
  && wget -q -O /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.5.4/terraform_1.5.4_linux_amd64.zip \
  && unzip /tmp/terraform.zip -d /usr/local/bin \
  && pip3 install --no-cache-dir --upgrade pip setuptools wheel \
  && pip3 install --no-cache-dir "ansible-core>=2.15,<2.16" pywinrm \
  && ansible-galaxy collection install "ansible.windows:==2.3.0" "community.general:==8.5.0" "microsoft.ad:==1.7.1" \
  && rm /tmp/terraform.zip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Pre-cache Terraform provider to avoid registry downloads at runtime
RUN mkdir -p /tmp/tf-mirror-init /usr/local/share/terraform/plugins \
  && { echo 'terraform {'; \
       echo '  required_providers {'; \
       echo '    proxmox = {'; \
       echo '      source  = "Telmate/proxmox"'; \
       echo '      version = "3.0.2-rc07"'; \
       echo '    }'; \
       echo '  }'; \
       echo '}'; } > /tmp/tf-mirror-init/main.tf \
  && terraform -chdir=/tmp/tf-mirror-init providers mirror /usr/local/share/terraform/plugins \
  && rm -rf /tmp/tf-mirror-init

RUN { echo 'provider_installation {'; \
      echo '  filesystem_mirror {'; \
      echo '    path    = "/usr/local/share/terraform/plugins"'; \
      echo '    include = ["registry.terraform.io/telmate/proxmox"]'; \
      echo '  }'; \
      echo '  direct {'; \
      echo '    exclude = ["registry.terraform.io/telmate/proxmox"]'; \
      echo '  }'; \
      echo '}'; } > /root/.terraformrc

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

CMD ["npm", "run", "demo"]
