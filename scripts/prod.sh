#!/usr/bin/env bash

export APP_STAGE=prod
yarn run db:migrate
tsx src/index.ts
