public class Probe {
  public static void main(String[] args) throws Exception {
    var serializer = new nl.beinformed.bi.core.configuration.serializer.castor.CastorComponentSerializer();
    try {
      var node = serializer.deserialize("sample.bixml", "<invalid/>");
      System.out.println(node == null ? "null" : node.getClass().getName());
    } catch (Throwable t) {
      t.printStackTrace();
      System.exit(2);
    }
  }
}
