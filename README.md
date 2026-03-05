# webviz

A browser-based visualization tool for [Tiled](https://blueskyproject.io/tiled/) datasets.

## Installation

### 1. Create a conda environment with Node.js

```bash
conda create -n webviz nodejs
conda activate webviz
```

### 2. Clone and install dependencies

```bash
git clone https://github.com/BCDA-APS/webviz.git
cd webviz
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
