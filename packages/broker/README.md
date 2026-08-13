# broker

Broker images are not published yet; build the image locally before using the
commands below.

```sh
docker volume create blitz-broker
docker pull ghcr.io/blitzdotdev/blitz-broker@sha256:<image-digest>
docker run -d --name blitz-broker --restart unless-stopped -p 2222:22 -v blitz-broker:/var/lib/blitz-broker ghcr.io/blitzdotdev/blitz-broker@sha256:<image-digest>
docker exec blitz-broker blitz-broker enroll --origin https://control.example --host broker.example --port 2222
```
