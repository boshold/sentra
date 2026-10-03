<script setup lang="ts">
const props = defineProps<{ input: number }>();
const doubled = props.input * 2;
throw new Error("ssr boom " + doubled);
</script>

<template>
  <main>
    <h1>SSR page</h1>
    <p>{{ doubled }}</p>
  </main>
</template>
