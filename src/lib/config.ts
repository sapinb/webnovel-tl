import * as path from 'path';
import * as dotenv from 'dotenv';
import * as yaml from 'js-yaml'; // Import js-yaml
import * as fs from 'fs/promises';
import { SeriesConfigurationsFileSchema, SeriesConfigurations } from './schema'

dotenv.config();

export const BASE_URL = process.env.BASE_URL || 'http://172.21.16.1:11434';
export const MODEL_NAME = process.env.MODEL_NAME || 'hf.co/unsloth/gemma-3-27b-it-qat-GGUF:latest';

// 📁 Base folder for all series
export const RAW_DL_DIR = path.resolve('outputs', 'raw');
export const TL_DIR = path.resolve('outputs', 'en');
export const SERIES_CONFIG_FILE = path.resolve('series-config.yaml'); // Path to your YAML config file

// This will hold the loaded configurations
let seriesConfigurations: SeriesConfigurations | null = null;

async function loadSeriesConfigurations(): Promise<SeriesConfigurations> {
    try {
        const fileContent = await fs.readFile(SERIES_CONFIG_FILE, 'utf-8');
        const seriesConfigurations = SeriesConfigurationsFileSchema.parse(yaml.load(fileContent));

        console.log(`✅ Loaded series configurations from ${SERIES_CONFIG_FILE}`);
        return seriesConfigurations;
    } catch (error) {
        console.error(`❌ Error loading series configurations from ${SERIES_CONFIG_FILE}:`, error);
        process.exit(1); // Exit if configurations cannot be loaded
    }
}

export function getOrLoadSeriesConfig(): Promise<SeriesConfigurations> {
    if (seriesConfigurations != null) {
        return Promise.resolve(seriesConfigurations);
    }
    return loadSeriesConfigurations()
}