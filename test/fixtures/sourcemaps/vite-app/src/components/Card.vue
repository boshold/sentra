<script setup lang="ts">
import { ref } from 'vue'

const count = ref(0)

function explode(input: number): number {
  const doubled = input * 2
  throw new Error('boom ' + doubled)
}

function onClick() {
  count.value = explode(count.value)
}
</script>

<template>
  <button @click="onClick">Count {{ count }}</button>
</template>

<style scoped>
button { color: red; }
</style>
