#!/bin/sh
# Rendered GIFs live on the volume at /data, not in the image.
#
# render.js writes to public/<network->gifs/, and on the droplet public/gifs is
# a symlink to public/_gifs_local. Reproduce that shape against the volume.
set -e
mkdir -p /data/gifs /app/public
rm -rf /app/public/gifs /app/public/_gifs_local
ln -sfn /data/gifs /app/public/gifs
ln -sfn /data/gifs /app/public/_gifs_local
echo "[entrypoint] $(find /data/gifs -name complete.gif 2>/dev/null | wc -l) rendered gifs on the volume"
exec "$@"
