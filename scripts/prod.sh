#!/usr/bin/env bash

export APP_STAGE=prod
yarn run migrate
tsx src/index.ts
