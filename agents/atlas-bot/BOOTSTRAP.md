# atlas-bot git trampoline

Intake still starts from the image (`/opt/atlas-bot/cook.sh` default in intake/server.py).
Every cook force-pulls LibreServ to `/data/LibreServ` and reexecs the git `agents/atlas-bot/cook.sh`.
Secrets stay in the env file. Ticket clones stay in `/tmp` (atlas cooks any LibreLoom repo).

Recreate still loses the `/opt` trampoline unless the image COPY includes this `cook.sh`.
Do not `docker stop` atlas to deploy; `docker cp cook.sh` into the running container is enough
for the trampoline. Do not share lock-bot or docs-bot `/data`.
