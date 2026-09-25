import { defineConfig } from '@playwright/test'
export default defineConfig({testDir:'./e2e-preview',timeout:60000,retries:0,workers:1,reporter:'line',use:{baseURL:'http://127.0.0.1:5173',video:'on',trace:'retain-on-failure'},webServer:{command:'npm run dev:preview',url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:60000}})
