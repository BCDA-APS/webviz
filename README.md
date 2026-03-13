# Kestrel

A browser-based visualization tool for [Tiled](https://blueskyproject.io/tiled/) datasets.

| CI/CD | Coverage | Documentation | License |
|-------|----------|---------------|---------|
| [![CI](https://github.com/BCDA-APS/kestrel/actions/workflows/ci.yml/badge.svg)](https://github.com/BCDA-APS/kestrel/actions/workflows/ci.yml) | [![codecov](https://codecov.io/gh/BCDA-APS/kestrel/branch/main/graph/badge.svg)](https://codecov.io/gh/BCDA-APS/kestrel) | [![docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://bcda-aps.github.io/kestrel/) | [![License](https://img.shields.io/badge/License-ANL-blue)](LICENSE) |

## Installation

### 1. Create a conda environment with Node.js

```bash
conda create -n kestrel nodejs
conda activate kestrel
```

### 2. Clone and install dependencies

```bash
git clone https://github.com/BCDA-APS/kestrel.git
cd kestrel
npm install
```

### 3. Run the development server

```bash
npm run dev
```

Then open the URL shown in the terminal (typically `http://localhost:5173`).

## Usage

1. Enter your Tiled server URL and click **Connect**
2. Select a catalog from the dropdown
3. Click a run to browse its datasets
4. Click a dataset to add it to the visualization grid
