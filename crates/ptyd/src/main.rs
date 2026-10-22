fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("treeix-ptyd {}", treeix_ptyd::BUILD);
        return Ok(());
    }
    treeix_ptyd::run(treeix_ptyd::Opts {
        data_dir: treeix_proto::data_dir(),
        handle_signals: true,
    })
}
