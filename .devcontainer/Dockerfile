FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# The typescript-node image has a 'node' user at UID/GID 1000 but no 'vscode' user.
# We rename node -> vscode so remoteUser: vscode works, keeping the same UID/GID.
RUN groupmod --new-name vscode node \
	&& usermod --login vscode --home /home/vscode --move-home node \
	&& echo "vscode ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/vscode \
	&& chmod 0440 /etc/sudoers.d/vscode

RUN npm install -g pnpm @google/gemini-cli

ENV PNPM_HOME="/home/vscode/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"