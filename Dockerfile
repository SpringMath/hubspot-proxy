# Pin the multi-architecture Node 24 base. Refresh this digest through review.
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81

LABEL org.opencontainers.image.source="https://github.com/SpringMath/hubspot-proxy"
LABEL org.opencontainers.image.description="Pipeline- and marker-scoped HubSpot support broker"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app

# This application has no runtime packages and needs no install/build step.
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["node"]
CMD ["src/server.js"]
