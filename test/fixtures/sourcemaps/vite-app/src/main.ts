import { createApp } from 'vue'
import Card from './components/Card.vue'
const app = createApp(Card)
app.config.errorHandler = (e) => { (window as unknown as { __stack: string }).__stack = (e as Error).stack ?? '' }
app.mount('#app')
