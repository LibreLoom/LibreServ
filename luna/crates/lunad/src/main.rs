#[tokio::main]
async fn main() -> anyhow::Result<()> {
    lunad::boot::run().await
}
