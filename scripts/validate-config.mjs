import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultConfigPath = path.join(rootDirectory, 'rally.config.json')
const schemaPath = path.join(rootDirectory, 'rally.config.schema.json')

function invalid(message) {
  throw new Error(`Invalid Rally configuration: ${message}`)
}

function httpsOrigin(value, location) {
  let url
  try {
    url = new URL(value)
  } catch {
    invalid(`${location} must be a valid URL.`)
  }
  if (url.protocol !== 'https:' || url.origin !== value) {
    invalid(`${location} must be an HTTPS origin without a path, query, or trailing slash.`)
  }
}

function schemaError(error) {
  const location = error.instancePath || 'config'
  if (error.keyword === 'additionalProperties') {
    return `${location} contains unknown setting ${error.params.additionalProperty}.`
  }
  return `${location} ${error.message}.`
}

export function validateConfig(configPath = defaultConfigPath) {
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    invalid(`could not read ${configPath}: ${error.message}`)
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv2020({ allErrors: true })
  ajv.addFormat('uri', (value) => {
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  })
  const validate = ajv.compile(schema)
  if (!validate(config)) invalid(validate.errors.map(schemaError).join(' '))

  httpsOrigin(config.deployment.apiBaseUrl, 'deployment.apiBaseUrl')
  config.deployment.allowedOrigins.forEach((origin, index) => {
    httpsOrigin(origin, `deployment.allowedOrigins[${index}]`)
  })

  return config
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = path.resolve(process.argv[2] || defaultConfigPath)
  try {
    validateConfig(configPath)
    console.log(`Valid Rally configuration: ${path.relative(rootDirectory, configPath)}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}