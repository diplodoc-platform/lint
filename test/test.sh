#!/usr/bin/env bash

set -e

npm i @diplodoc/lint
npx @diplodoc/lint init
npm run lint:fix